#!/usr/bin/env node
/* ===========================================================================
   CIRCA CONTEST OWNERSHIP — the parser, the database, and the edge function.

     CORE     football/market_structure/circa_core.js: team resolution through
              EdgeDesk's alias table, pick and entry parsing, wrapped entries,
              unread rows, the stated entry total, aggregation, quarantine,
              validation, where the PDF lives, which contest week it is.
     DRIFT    the club table = lib/football_identity.js NFL_TEAMS; the copy
              inside supabase/functions/circa_ownership_sync/index.ts = the core.
     PDF      the SYNTHETIC fixtures in tools/football/fixtures/circa/ read
              through unpdf (the same library the function bundles): the clean
              one parses to exactly its stated 40 entries; the one whose cells
              wrap inside themselves FAILS and publishes nothing. Needs unpdf
              (`require('unpdf')`, or EDGEDESK_UNPDF=<path to the package>);
              announced and skipped without it.
     DB       supabase/nfl_market_structure.sql + contest_ownership.sql on a real
              PostgreSQL: a run is accepted only when its rows add up; a
              complete run cannot carry quarantine; a failed fetch is a WARNING
              before Sunday 13:00 ET and a FAILURE after; the card's view never
              shows a failed run or stands last week in for this one; append-only.
     E2E      the edge function itself under Deno (EDGEDESK_DENO=<deno binary>),
              against a stub Supabase and the fixture PDF; what it sends to
              contest_ownership_ingest is then written to the real database.
              Announced and skipped without Deno.

   No real Circa document is used anywhere: this environment cannot reach
   circasports.com. docs/market-structure/README.md says what to check on the
   first live week.

     node tools/football/circa_ownership.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const ROOT = path.resolve(__dirname, '..', '..');
const C = require(path.join(ROOT, 'football', 'market_structure', 'circa_core.js'));
const INL = require(path.join(__dirname, 'inline_circa_core.js'));
const FIX = path.join(__dirname, 'fixtures', 'circa');
const EXPECT = JSON.parse(fs.readFileSync(path.join(FIX, 'synthetic_week7.expected.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [], notes = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* the week's games as the function would build them from public.signals */
const WEEK7 = [['CIN', 'BAL'], ['CLE', 'TEN'], ['DAL', 'PHI'], ['DEN', 'ARI'], ['GB', 'DET'], ['IND', 'MIN'], ['KC', 'SEA'], ['LAR', 'LV'], ['MIA', 'NYJ'],
  ['NE', 'CHI'], ['NYG', 'HOU'], ['PIT', 'NO'], ['SF', 'ATL'], ['TB', 'CAR']];
const EV = {};
WEEK7.forEach(([a, h], i) => { EV[a] = EV[h] = { event_id: 'ev7_' + i, home_code: h, away_code: a }; });

/* ---------------------------------------------------------------- CORE */
chk('nicknames resolve (EAGLES, 49ERS, BUCS, NINERS)', C.circaResolveTeam('EAGLES').code === 'PHI' && C.circaResolveTeam('49ERS').code === 'SF'
  && C.circaResolveTeam('Bucs').code === 'TB' && C.circaResolveTeam('NINERS').code === 'SF');
chk('cities, codes and full names resolve', C.circaResolveTeam('GREEN BAY').code === 'GB' && C.circaResolveTeam('KC').code === 'KC'
  && C.circaResolveTeam('Los Angeles Chargers').code === 'LAC' && C.circaResolveTeam('LA RAMS').code === 'LAR');
chk('a city naming two clubs is ambiguous, never a guess', C.circaResolveTeam('NEW YORK').reason === 'ambiguous_team' && eq(C.circaResolveTeam('NEW YORK').candidates.sort(), ['NYG', 'NYJ'])
  && C.circaResolveTeam('LOS ANGELES').reason === 'ambiguous_team');
chk('a club that does not exist is unresolved', C.circaResolveTeam('SPACE CADETS').code === null && C.circaResolveTeam('SPACE CADETS').reason === 'unresolved_team');
chk('a trailing mark does not stop the club resolving', C.circaResolveTeam('EAGLES *').code === 'PHI');
chk('every club resolves by code, by name and by nickname', C.CIRCA_NFL_TEAMS.every((t) => C.circaResolveTeam(t[0]).code === t[0] && C.circaResolveTeam(t[1]).code === t[0]
  && C.circaResolveTeam(t[1].split(' ').slice(-1)[0]).code === t[0]));
chk('picks: "16. EAGLES +1", "3. 49ERS -3½", "22. CHIEFS PK", "5. JETS −2.5"', () => {
  const p = C.circaPicksOf('ENTRY 9 LLC 16. EAGLES +1 3. 49ERS -3½ 22. CHIEFS PK 5. JETS −2.5 7. NEW ENGLAND -10');
  return eq(p.map((x) => [x.num, x.team_raw, x.line]), [[16, 'EAGLES', 1], [3, '49ERS', -3.5], [22, 'CHIEFS', 0], [5, 'JETS', -2.5], [7, 'NEW ENGLAND', -10]]);
});
chk('an entry name with a number in it is not a pick', C.circaPicksOf('77 TEAM 7 SMITH 1. BENGALS +3').length === 1);
{
  const lines = ['CIRCA SPORTS MILLION VIII', 'WEEK 7 SELECTIONS', 'TOTAL ENTRIES: 4',
    '1 A 1. BENGALS +3 4. TITANS +1.5 6. EAGLES +4.5 10. LIONS -3 13. CHIEFS +2.5',
    '2 A LONG NAME 1. BENGALS +3 4. TITANS +1.5 6. EAGLES +4.5', '10. LIONS -3 13. CHIEFS +2.5',
    '3 C 2. RAVENS -3 3. BROWNS -1.5',
    '4 D 2. RAVENS -3 3. BROWNS -1.5 5. COWBOYS -4.5 7. BRONCOS -4.5 9. PACKERS +3'];
  const P = C.circaParse(lines);
  chk('parse: whole rows, a wrapped row, an unread short row, the header', P.entries.length === 3 && P.entries.filter((e) => e.wrapped).length === 1
    && P.anomalies.length === 1 && P.anomalies[0].n_picks === 2 && P.stated_entries === 4 && P.week === 7 && P.edition === 'VIII', P);
  chk('a short row followed by a whole row: the whole row is still an entry', P.entries.some((e) => e.row === 7));
  const A = C.circaAggregate(P, (c) => EV[c] || null);
  chk('aggregate: 15 picks placed, share of cards and of the game', A.picks_resolved === 15 && A.picks_quarantined === 0
    && A.sides.filter((s) => s.team_code === 'CIN')[0].picks === 2 && A.sides.filter((s) => s.team_code === 'CIN')[0].share_of_cards === 0.666667
    && A.sides.filter((s) => s.team_code === 'CIN')[0].share_of_game === 0.666667 && A.sides.filter((s) => s.team_code === 'BAL')[0].share_of_game === 0.333333, A.sides);
  const V = C.circaValidate(P, A, { week: 7, max_anomaly_share: 0.5 });
  chk('an unread row makes the run PARTIAL, never complete', V.status === 'partial' && V.rows_unread === 1, V);
  chk('the stated total counts unread rows too (4 rows = 4 entries stated)', !V.fatal.includes('entry_count_mismatch'));
  chk('a stated total the rows do not reach is a FAILURE', C.circaValidate(Object.assign({}, P, { stated_entries: 9 }), A).fatal.includes('entry_count_mismatch'));
  chk('the wrong week is a FAILURE', C.circaValidate(P, A, { week: 8 }).fatal.includes('wrong_week'));
  chk('more than 1% unread is a format change (FAILURE)', C.circaValidate(P, A, { max_anomaly_share: 0.01 }).fatal.includes('format_changed'));
  chk('nothing parsed is a FAILURE', C.circaValidate(C.circaParse(['no picks here']), null).fatal.includes('no_entries_parsed'));
}
{
  const P = C.circaParse(['1 A 1. BENGALS +3 4. TITANS +1.5 6. EAGLES +4.5 10. LIONS -3 13. CHIEFS +2.5', '2 B 1. BENGALS +3.5 4. TITANS +1.5 6. EAGLES +4.5 10. LIONS -3 13. CHIEFS +2.5',
    '3 C 1. BENGALS +3 4. TITANS +1.5 6. EAGLES +4.5 10. LIONS -3 13. CHIEFS +2.5']);
  const A = C.circaAggregate(P, (c) => EV[c] || null);
  chk('a club at two contest lines: the minority line is quarantined, not averaged', A.quarantine.length === 1 && A.quarantine[0].reason === 'conflicting_contest_line'
    && A.quarantine[0].picks === 1 && A.sides.filter((s) => s.team_code === 'CIN')[0].contest_line === 3 && A.picks_resolved + A.picks_quarantined === 15, A.quarantine);
}
chk('lines from pdf.js items: by baseline, then left to right, whatever the item order', eq(C.circaLinesFromItems([
  { str: '2. RAVENS -3', transform: [1, 0, 0, 1, 200, 700] }, { str: 'ENTRY 1', transform: [1, 0, 0, 1, 10, 700.8] }, { str: 'TOTAL ENTRIES: 1', transform: [1, 0, 0, 1, 10, 740] },
  { str: '1. BENGALS +3', transform: [1, 0, 0, 1, 120, 699.5] }]), ['TOTAL ENTRIES: 1', 'ENTRY 1 1. BENGALS +3 2. RAVENS -3']));
chk('the PDF is looked for in the Saturday\'s upload month, then the Thursday\'s, then the next', () => {
  const u = (y, m, w) => 'https://www.circasports.com/wp-content/uploads/' + y + '/' + m + '/Circa-Sports-Million-VIII-Week-' + w + '-Selections.pdf';
  return eq(C.circaUrlCandidates('VIII', 6, '2026-10-17'), [u(2026, '10', 6), u(2026, '11', 6)])
    && eq(C.circaUrlCandidates('VIII', 17, '2027-01-02'), [u(2027, '01', 17), u(2026, '12', 17), u(2027, '02', 17)]);
});
chk('a link on the site is found by edition and week, not by the first PDF on the page', C.circaFindLink(
  '<a href="/wp-content/uploads/2026/10/Circa-Sports-Survivor-Week-6.pdf">s</a><a href="https://www.circasports.com/wp-content/uploads/2026/10/Circa-Sports-Million-VIII-Week-5-Selections.pdf">5</a>'
  + '<a href="https://www.circasports.com/wp-content/uploads/2026/10/Circa-Sports-Million-VIII-Week-6-Selections.pdf">6</a>', 'VIII', 6)
  === 'https://www.circasports.com/wp-content/uploads/2026/10/Circa-Sports-Million-VIII-Week-6-Selections.pdf');
chk('contest week: Saturday 2026-10-24 is Week 7; it turns over on Tuesday; before Week 1 is none', C.circaContestWeek('2026-09-10', Date.parse('2026-10-24T15:00:00Z')) === 7
  && C.circaContestWeek('2026-09-10', Date.parse('2026-10-19T23:00:00Z')) === 6 && C.circaContestWeek('2026-09-10', Date.parse('2026-10-20T15:00:00Z')) === 7
  && C.circaContestWeek('2026-09-10', Date.parse('2026-08-30T15:00:00Z')) === null);
chk('the Week 7 window covers Thursday night to Monday night', () => { const w = C.circaWeekWindow('2026-09-10', 7);
  return w.saturday === '2026-10-24' && Date.parse(w.from) < Date.parse('2026-10-23T00:15:00Z') && Date.parse(w.to) > Date.parse('2026-10-27T00:15:00Z'); });

/* --------------------------------------------------------------- DRIFT */
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'football_identity.js'), 'utf8');
  const a = src.indexOf('var NFL_TEAMS = ['), b = src.indexOf('];', a);
  const theirs = Function('return ' + src.slice(a + 'var NFL_TEAMS = '.length, b + 1))();
  chk('the club table = lib/football_identity.js NFL_TEAMS, verbatim', eq(theirs, C.CIRCA_NFL_TEAMS), theirs.length);
}
chk('the edge function carries the core verbatim (node tools/football/inline_circa_core.js)', INL.current());
{
  const fn = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'circa_ownership_sync', 'index.ts'), 'utf8');
  chk('the function pins its PDF library to an exact version', /npm:unpdf@\d+\.\d+\.\d+"/.test(fn));
  chk('the function checks x-cron-secret and refuses when its secret is unset', /x-cron-secret/.test(fn) && /CIRCA_CRON_SECRET is not set/.test(fn));
  chk('the function never writes a failed run as rows (failed → contest_ownership_fail)', /v\.status === "failed"[\s\S]{0,80}fail\(/.test(fn));
  ['contest_ownership.sql', 'contest_ownership_cron.sql'].forEach((f) => {
    const s = fs.readFileSync(path.join(ROOT, 'supabase', f), 'utf8');
    chk(f + ': no psql meta-command, ends in a report', !/^\s*\\/m.test(s) && /THE REPORT[\s\S]*select piece, state/.test(s));
  });
}

/* ----------------------------------------------------------------- PDF */
let unpdf = null;
try { unpdf = require(process.env.EDGEDESK_UNPDF || 'unpdf'); } catch (_) { unpdf = null; }
async function pdfLines(file) {
  const pdf = await unpdf.getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) { const tc = await (await pdf.getPage(i)).getTextContent(); out.push(...C.circaLinesFromItems(tc.items, 2)); }
  return out;
}

(async () => {
  let fromPdf = null;
  if (!unpdf) notes.push('NOTE | unpdf not installed: the PDF layer did not run (npm i unpdf@1.8.1, or EDGEDESK_UNPDF=<path>)');
  else {
    const P = C.circaParse(await pdfLines(path.join(FIX, 'synthetic_week7.pdf')));
    const A = C.circaAggregate(P, (c) => EV[c] || null), V = C.circaValidate(P, A, { week: 7 });
    fromPdf = { P, A, V };
    chk('PDF: every one of the stated 40 entries reads, the wrapped one included', P.entries.length === EXPECT.entries && P.stated_entries === EXPECT.stated
      && P.entries.filter((e) => e.wrapped).length === EXPECT.wrapped_entries && P.anomalies.length === 0, { e: P.entries.length, s: P.stated_entries, a: P.anomalies });
    chk('PDF: 200 picks = 197 placed + 3 quarantined, each with its reason', A.picks_parsed === EXPECT.picks && A.picks_resolved + A.picks_quarantined === EXPECT.picks
      && eq(A.quarantine.map((q) => [q.team_raw, q.reason]).sort(), EXPECT.quarantined.map((q) => [q.team_raw, q.reason]).sort()), A.quarantine);
    chk('PDF: published as PARTIAL (quarantine), never as complete', V.status === 'partial' && V.fatal.length === 0, V);
    chk('PDF: every contest line read matches the document (side numbers and lines)', A.sides.every((s) => { const e = EXPECT.sides.filter((x) => x.no === s.contest_game_no)[0];
      return e && C.circaResolveTeam(e.team).code === s.team_code && e.line === s.contest_line; }), A.sides.slice(0, 3));
    chk('PDF: the sides of each game add up to that game\'s picks; shares of each game sum to 1', (() => {
      const g = {}; A.sides.forEach((s) => { (g[s.event_id] = g[s.event_id] || { p: 0, sh: 0, gp: s.game_picks }); g[s.event_id].p += s.picks; g[s.event_id].sh += s.share_of_game; });
      return Object.values(g).every((x) => x.p === x.gp && Math.abs(x.sh - 1) < 1e-5);
    })());
    const W = C.circaParse(await pdfLines(path.join(FIX, 'synthetic_week7_cellwrap.pdf')));
    const WV = C.circaValidate(W, C.circaAggregate(W, (c) => EV[c] || null), { week: 7 });
    chk('PDF: a layout whose cells wrap inside themselves FAILS (nothing is published from it)', WV.status === 'failed' && WV.fatal.length > 0, WV);
  }

  /* ------------------------------------------------------------- DB */
  const { findPgBin, startCluster } = require(path.join(ROOT, 'tools', 'collective', 'pg_harness.js'));
  const BIN = findPgBin();
  let pg = null;
  if (!BIN) notes.push('NOTE | no postgres binary: the database layer did not run');
  else { pg = startCluster(BIN, 'circa'); if (!pg.ok) { notes.push('NOTE | could not start postgres: ' + pg.why); pg = null; } }
  const q = (sql) => { const f = path.join(os.tmpdir(), 'circa_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.sql'); fs.writeFileSync(f, sql); const s = pg.stage(f); fs.unlinkSync(f); return pg.psql('-d co -X -q -t -A -v ON_ERROR_STOP=1 -f ' + s); };
  const one = (sql) => { const r = q(sql); if (r.status !== 0) throw new Error(r.out); return r.out.trim(); };
  const json = (sql) => { const o = one(sql); return o ? JSON.parse(o) : null; };
  const lit = (o) => '$j$' + JSON.stringify(o) + '$j$';
  function runOf(agg, parsed, status, extra) {
    return Object.assign({ run_id: require('crypto').randomUUID(), contest: 'circa_million', season: 2026, week: 7, status,
      entries_stated: parsed.stated_entries, entries_parsed: parsed.entries.length, rows_unread: parsed.anomalies.length, picks_parsed: parsed.picks_parsed,
      picks_resolved: agg.picks_resolved, picks_quarantined: agg.picks_quarantined, source_url: 'https://example.invalid/w7.pdf', source_sha256: 'x', parser_version: C.CIRCA_CORE_VERSION,
      fetched_at: '2026-10-17T15:05:00Z' }, extra || {});
  }
  const qOf = (agg, parsed) => agg.quarantine.concat(parsed.anomalies.map((a) => ({ row: a.row, team_raw: a.text, picks: Math.max(1, a.n_picks), reason: 'unread_row' })));
  if (pg) {
    pg.psql('-d postgres -q -c "create database co"');
    one(`do $r$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if; end $r$;
      grant usage on schema public to anon, authenticated, service_role;
      create table public.signals (id bigserial primary key, sig_key text unique not null, event_id text, sport_key text, commence_time timestamptz, home_team text, away_team text,
        market text, selection text, point numeric, last_seen_at timestamptz, best_dec numeric, sharp_fair numeric, n_books integer, closing_sharp_fair numeric);
      create table public.signal_ticks (id bigserial primary key, sig_key text not null, created_at timestamptz not null, best_dec numeric, sharp_fair numeric, n_books integer);
      create index signal_ticks_sig_created_idx on public.signal_ticks (sig_key, created_at);`);
    ['nfl_market_structure.sql', 'contest_ownership.sql'].forEach((f) => {
      const s = pg.stage(path.join(ROOT, 'supabase', f));
      const r1 = pg.psql('-d co -X -v ON_ERROR_STOP=1 -f ' + s), r2 = pg.psql('-d co -X -v ON_ERROR_STOP=1 -f ' + s);
      chk('DB: ' + f + ' applies, twice', r1.status === 0 && r2.status === 0, (r1.out + r2.out).slice(-900));
      chk('DB: ' + f + ' report reads ok', r2.out.split('\n').filter((l) => /\|\s*(ok|CHECK THIS)/.test(l)).every((l) => /\|\s*ok\s*$/.test(l)), r2.out.slice(-900));
    });
    /* the Saturday / Sunday poke (stub cron, vault and net: this server has none of them) */
    one(`create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
create or replace function cron.schedule(p_name text, p_sched text, p_cmd text) returns bigint language sql as $f$
  insert into cron.job (jobname, schedule, command) values (p_name, p_sched, p_cmd) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $f$;
create or replace function cron.unschedule(p_id bigint) returns boolean language sql as $f$ delete from cron.job where jobid = p_id returning true $f$;
      create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text primary key, decrypted_secret text);
      create schema if not exists net; create table if not exists net.sent (id bigserial primary key, url text, body jsonb, headers jsonb);
      create or replace function net.http_post(url text, body jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
        returns bigint language sql as $f$ insert into net.sent (url, body, headers) values (url, body, headers) returning id $f$;`);
    {
      const cr = pg.stage(path.join(ROOT, 'supabase', 'contest_ownership_cron.sql'));
      const c1 = pg.psql('-d co -X -A -t -v ON_ERROR_STOP=1 -f ' + cr), c2 = pg.psql('-d co -X -A -t -v ON_ERROR_STOP=1 -f ' + cr);
      chk('DB: the contest cron applies, and again', c1.status === 0 && c2.status === 0, (c1.out + c2.out).slice(-600));
      chk('DB: Saturday every two hours and Sunday morning, both poking the sync', one(`select string_agg(jobname || '=' || schedule, ',' order by jobname) from cron.job where command like '%circa_ownership_poke%'`)
        === 'circa_ownership_saturday=7 14,16,18,20,22 * * 6,circa_ownership_sunday=7 12,14,16 * * 0');
      chk('DB: the report says when the Vault secret is missing', /3 Vault circa_cron_secret is set\|CHECK THIS/.test(c2.out), c2.out.slice(-300));
      const miss = json(`select public.circa_ownership_poke();`);
      chk('DB: no secret: nothing is sent, and a FAILURE alert survives (recorded, not rolled back)', miss && miss.queued === false && one('select count(*) from net.sent') === '0'
        && one(`select count(*) from public.market_structure_alerts where code = 'no_cron_secret' and severity = 'FAILURE'`) === '1', miss);
      one(`insert into vault.decrypted_secrets values ('circa_cron_secret', 's3cret');`);
      const sent = json(`select public.circa_ownership_poke();`);
      chk('DB: with the secret: one POST to the function carrying x-cron-secret', sent && sent.queued === true
        && one(`select url || ' ' || (headers ->> 'x-cron-secret') from net.sent`) === 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/circa_ownership_sync s3cret');
      chk('DB: anon cannot poke', q(`set role anon; select public.circa_ownership_poke();`).status !== 0);
    }
    const P = fromPdf ? fromPdf.P : C.circaParse(['1 A 1. BENGALS +3 4. TITANS +1.5 6. EAGLES +4.5 10. LIONS -3 13. CHIEFS +2.5', '2 B 1. BENGALS +3 4. TITANS +1.5 6. EAGLES +4.5 10. LIONS -3 99. SPACE CADETS +3']);
    const A = fromPdf ? fromPdf.A : C.circaAggregate(P, (c) => EV[c] || null);
    const st = C.circaValidate(P, A).status;
    const okRun = runOf(A, P, st);
    const r = json(`set role service_role; select public.contest_ownership_ingest(${lit(okRun)}::jsonb, ${lit(A.sides)}::jsonb, ${lit(qOf(A, P))}::jsonb);`);
    chk('DB: the parsed week is accepted and its counts recorded', r && r.status === st && r.sides === A.sides.length, r);
    chk('DB: every pick is in a side row or the quarantine — nothing dropped', Number(one(`select (select coalesce(sum(picks),0) from public.contest_ownership where run_id = '${okRun.run_id}')
      + (select coalesce(sum(picks),0) from public.contest_ownership_quarantine where run_id = '${okRun.run_id}' and reason <> 'unread_row')`)) === P.picks_parsed);
    chk('DB: the card view labels the run with its status and quarantine count', one(`select distinct run_status || '/' || picks_quarantined from public.contest_ownership_latest where week = 7`)
      === st + '/' + A.picks_quarantined);
    chk('DB: a partial run raises a WARNING', st !== 'partial' || one(`select count(*) from public.market_structure_alerts where module = 'circa_ownership' and code = 'partial'`) === '1');
    chk('DB: a run whose rows do not add up is refused', q(`set role service_role; select public.contest_ownership_ingest(${lit(runOf(A, P, st, { picks_resolved: A.picks_resolved + 1 }))}::jsonb, ${lit(A.sides)}::jsonb, ${lit(qOf(A, P))}::jsonb);`).status !== 0);
    chk('DB: a run calling itself complete while carrying quarantine is refused', A.picks_quarantined === 0
      || q(`set role service_role; select public.contest_ownership_ingest(${lit(runOf(A, P, 'complete'))}::jsonb, ${lit(A.sides)}::jsonb, ${lit(qOf(A, P))}::jsonb);`).status !== 0);
    chk('DB: a stated total the rows do not reach is refused by the table', q(`set role service_role; select public.contest_ownership_ingest(${lit(runOf(A, P, st, { entries_stated: 999 }))}::jsonb, ${lit(A.sides)}::jsonb, ${lit(qOf(A, P))}::jsonb);`).status !== 0);
    chk('DB: a game whose sides do not add up to its picks is refused', q(`set role service_role; select public.contest_ownership_ingest(${lit(runOf(A, P, st))}::jsonb,
      ${lit(A.sides.map((s, i) => i === 0 ? Object.assign({}, s, { game_picks: s.game_picks + 5 }) : s))}::jsonb, ${lit(qOf(A, P))}::jsonb);`).status !== 0);
    chk('DB: anon cannot write a run', q(`set role anon; select public.contest_ownership_ingest(${lit(okRun)}::jsonb, '[]'::jsonb, '[]'::jsonb);`).status !== 0);
    chk('DB: anon reads the card view', Number(one(`set role anon; select count(*) from public.contest_ownership_latest`)) === A.sides.length);
    chk('DB: an ownership row cannot be changed or deleted', q(`update public.contest_ownership set picks = picks + 1;`).status !== 0 && q(`delete from public.contest_ownership_quarantine;`).status !== 0);
    /* a failed fetch: severity by the clock, and the card never shows it */
    const early = json(`set role service_role; select public.contest_ownership_fail('circa_million', 2026, 52 - 30, 'pdf_not_found', 'test', null, null, null);`);
    chk('DB: a missing PDF before that week\'s Sunday 13:00 ET is a WARNING', early && early.severity === 'WARNING', early);
    const late = json(`set role service_role; select public.contest_ownership_fail('circa_million', 2026, 6, 'pdf_not_found', 'test', null, null, null);`);
    chk('DB: after it, a FAILURE', late && late.severity === 'FAILURE', late);
    const fmt = json(`set role service_role; select public.contest_ownership_fail('circa_million', 2026, 22, 'format_changed', 'test', null, null, null);`);
    chk('DB: any other failure is a FAILURE at once', fmt && fmt.severity === 'FAILURE');
    one(`set role service_role; select public.contest_ownership_fail('circa_million', 2026, 7, 'format_changed', 'a later broken read', null, null, null);`);
    chk('DB: a later failed run does not erase the week\'s good numbers, and the status view says it failed', Number(one(`select count(*) from public.contest_ownership_latest where week = 7`)) === A.sides.length
      && one(`select status from public.contest_ownership_status where week = 7`) === 'failed');
    chk('DB: a week with only a failure shows nothing on the card (last week never stands in)', one(`select count(*) from public.contest_ownership_latest where week = 6`) === '0');
    chk('DB: a failed run cannot be sent through the ingest door', q(`set role service_role; select public.contest_ownership_ingest(${lit(runOf(A, P, 'failed'))}::jsonb, '[]'::jsonb, '[]'::jsonb);`).status !== 0);
  }

  /* ------------------------------------------------------------- E2E */
  const DENO = process.env.EDGEDESK_DENO;
  if (!DENO || !unpdf) notes.push('NOTE | the edge-function layer did not run (needs EDGEDESK_DENO=<deno binary> and unpdf)');
  else {
    const pdfBytes = fs.readFileSync(path.join(FIX, 'synthetic_week7.pdf'));
    const calls = [];
    const events = []; WEEK7.forEach(([a, h], i) => { const name = (c) => C.CIRCA_NFL_TEAMS.filter((t) => t[0] === c)[0][1];
      events.push({ event_id: 'ev7_' + i, home_team: name(h), away_team: name(a), commence_time: '2026-10-25T17:00:00Z' }); });
    const stub = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        const u = req.url;
        const send = (code, obj, type) => { res.writeHead(code, { 'content-type': type || 'application/json' }); res.end(type ? obj : JSON.stringify(obj)); };
        if (u.startsWith('/w7.pdf')) return send(200, pdfBytes, 'application/pdf');
        if (u.startsWith('/missing.pdf')) return send(404, 'no', 'text/plain');
        if (u.startsWith('/rest/v1/contest_ownership_config')) return send(200, [{ contest: 'circa_million', season: 2026, edition: 'VIII', week1_thursday: '2026-09-10', enabled: true }]);
        if (u.startsWith('/rest/v1/contest_ownership_status') || u.startsWith('/rest/v1/contest_ownership_runs')) return send(200, []);
        if (u.startsWith('/rest/v1/signals')) { calls.push({ path: u }); return send(200, events); }
        if (u.startsWith('/rest/v1/rpc/')) { calls.push({ rpc: u.slice('/rest/v1/rpc/'.length), body: JSON.parse(b || '{}') }); return send(200, { ok: true }); }
        send(404, { error: u });
      });
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const sport = stub.address().port, fport = 18000 + (process.pid % 1000);
    const env = Object.assign({}, process.env, { SUPABASE_URL: 'http://127.0.0.1:' + sport, SUPABASE_SERVICE_ROLE_KEY: 'svc', CIRCA_CRON_SECRET: 'sekret', NO_COLOR: '1',
      DENO_DIR: process.env.DENO_DIR || path.join(os.tmpdir(), 'edgedesk-deno-cache') });
    const shim = path.join(os.tmpdir(), 'circa_serve_' + process.pid + '.ts');
    fs.writeFileSync(shim, 'const s = Deno.serve; (Deno as any).serve = (h: any) => s({ port: ' + fport + ', hostname: "127.0.0.1", onListen() { console.log("LISTENING"); } }, h);\n'
      + 'await import(' + JSON.stringify('file://' + path.join(ROOT, 'supabase', 'functions', 'circa_ownership_sync', 'index.ts')) + ');\n');
    const proc = cp.spawn(DENO, ['run', '--allow-net', '--allow-env', '--allow-read', '--no-check', shim], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const ready = new Promise((resolve) => { const t = setTimeout(() => resolve(false), 120000); const on = (d) => { log += d; if (/LISTENING/.test(log)) { clearTimeout(t); resolve(true); } };
      proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', () => resolve(false)); });
    const up = await ready;
    chk('E2E: the function starts under Deno', up, log.slice(-600));
    const call = async (body, secret) => { const r = await fetch('http://127.0.0.1:' + fport + '/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cron-secret': secret }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() }; };
    if (up) {
      const health = await (await fetch('http://127.0.0.1:' + fport + '/')).json();
      chk('E2E: GET is a health probe carrying BUILD and the core version', health.ok && /circa_ownership_sync@/.test(health.build) && health.core === C.CIRCA_CORE_VERSION, health);
      chk('E2E: a wrong secret is refused', (await call({ week: 7 }, 'nope')).status === 401);
      const dry = await call({ week: 7, url: 'http://127.0.0.1:' + sport + '/w7.pdf', dry: true }, 'sekret');
      chk('E2E: a dry run parses the PDF and writes nothing', dry.body.ok && dry.body.dry && dry.body.run.entries_parsed === 40 && !calls.some((x) => x.rpc), dry.body);
      const live = await call({ week: 7, url: 'http://127.0.0.1:' + sport + '/w7.pdf' }, 'sekret');
      const ing = calls.filter((x) => x.rpc === 'contest_ownership_ingest')[0];
      chk('E2E: a live run sends one ingest: 40 entries, 200 picks, partial', live.body.ok && ing && ing.body.p_run.entries_parsed === 40 && ing.body.p_run.picks_parsed === 200
        && ing.body.p_run.status === 'partial' && ing.body.p_run.source_url.endsWith('/w7.pdf') && /^[0-9a-f]{64}$/.test(ing.body.p_run.source_sha256), live.body);
      chk('E2E: it read the week\'s games from EdgeDesk\'s own capture (NFL spreads, the week\'s window)', calls.some((x) => x.path && /sport_key=eq\.americanfootball_nfl/.test(x.path) && /market=eq\.spreads/.test(x.path)));
      const miss = await call({ week: 7, url: 'http://127.0.0.1:' + sport + '/missing.pdf' }, 'sekret');
      const f = calls.filter((x) => x.rpc === 'contest_ownership_fail')[0];
      chk('E2E: a missing PDF is recorded as a failed run (pdf_not_found), not as rows', !miss.body.ok && f && f.body.p_code === 'pdf_not_found', miss.body);
      if (pg && ing) {
        const w = json(`set role service_role; select public.contest_ownership_ingest(${lit(Object.assign({}, ing.body.p_run, { week: 8 }))}::jsonb, ${lit(ing.body.p_sides)}::jsonb, ${lit(ing.body.p_quarantine)}::jsonb);`);
        chk('E2E → DB: what the function sends is accepted by the real database', w && w.status === 'partial' && w.quarantined_picks === 3, w);
      }
    }
    proc.kill('SIGTERM'); stub.close(); try { fs.unlinkSync(shim); } catch (_) {}
  }

  failures.forEach((x) => console.log('FAIL | ' + x.name + (x.detail !== undefined ? '  ' + JSON.stringify(x.detail).slice(0, 700) : '')));
  notes.forEach((n) => console.log(n));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
